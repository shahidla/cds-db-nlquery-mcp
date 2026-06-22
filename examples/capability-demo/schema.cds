namespace capdemo;

entity Customers {
  key ID    : String(10);
      NAME  : String(100) @title: 'Customer Name';
      NOTES : String(500);
      FIRST : String(50);
      LAST  : String(50);
      FULL  : String(101) = FIRST || ' ' || LAST;
      orders : Association to many Orders on orders.CUSTOMER_ID = ID;
}
annotate Customers with @cds.search: { NAME, NOTES };

entity Orders {
  key ID          : String(10);
      CUSTOMER_ID : String(10);
      AMOUNT      : Decimal(15,2) @Semantics.amount.currencyCode: 'CURRENCY';
      @NLP.label: 'Currency code (e.g. USD, EUR) — a text code, never numeric. Never SUM/AVG/MIN/MAX this column — aggregate AMOUNT instead.'
      CURRENCY    : String(3);
      STATUS      : String(1) enum { open = 'O'; closed = 'C'; };
      ORDER_DATE  : Date;
      customer    : Association to Customers on customer.ID = CUSTOMER_ID;
      items       : Composition of many OrderItems on items.ORDER_ID = ID;
}

entity OrderItems {
  key ID        : String(10);
      ORDER_ID  : String(10);
      PRODUCT_ID : String(10);
      PRODUCT   : String(50);
      QTY       : Integer;
      STATUS    : String(1) enum { pending = 'P'; shipped = 'S'; };
      product   : Association to Products on product.ID = PRODUCT_ID;
}

// to-one target nested two levels deep under Orders (Orders -[to-many]-> items
// -[to-one]-> product) — exercises enum/blocked-column/select recursion through a
// to-one expand branch specifically, which comes back as a plain object rather
// than an array (a real gap found by systematic testing: every JS post-processing
// step on expand results originally only ever checked Array.isArray()).
entity Products {
  key ID     : String(10);
      NAME   : String(50);
      SECRET : String(50);
      STATUS : String(1) enum { active = 'A'; discontinued = 'D'; };
}

entity Accounts {
  key ID        : String(10);
      NAME      : String(100);
      PARENT_ID : String(10);
      STATUS    : String(1) enum { active = 'A'; closed = 'X'; };
      parent    : Association to Accounts on parent.ID = PARENT_ID;
      children  : Association to many Accounts on children.PARENT_ID = ID;
}

entity Sectors {
  key CODE        : String(10);
      DESCRIPTION : String(100);
}

entity Loans {
  key ID     : String(10);
      DTI    : Decimal(5,2) @assert.range: [0, 50];
      SECTOR : String(10) @Common.ValueList: {
                 CollectionPath : 'Sectors',
                 Parameters     : [
                   { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: 'SECTOR', ValueListProperty: 'CODE' },
                   { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'DESCRIPTION' },
                 ],
               };
      sector : Association to Sectors on sector.CODE = SECTOR;
}

entity WorkAssignments {
  key ID       : String(10);
      EMPLOYEE : String(50);
      ROLE     : String(50);
      validFrom : Date @cds.valid.from;
      validTo   : Date @cds.valid.to;
}

entity InternalAudit {
  key ID : String(10);
      NOTE : String(200);
}
annotate InternalAudit with @cds.persistence.skip: true;
